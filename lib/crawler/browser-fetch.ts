/**
 * Browser-based fetch fallback.
 *
 * Some hosts (e.g. sites behind Vercel / Cloudflare bot protection) reject plain
 * `fetch()` requests with a 429 + JS "security checkpoint" challenge, returning an
 * HTML challenge page instead of the real resource — but they serve the real
 * content to a full browser that can execute the challenge JS. robots.txt and
 * sitemap discovery use plain fetch for speed; when that is blocked, falling back
 * to a real Chromium navigation lets the audit still find pages to crawl.
 *
 * Expensive (launches a throwaway browser) — call only as a fallback after a
 * plain fetch has failed or returned an unexpected (non-XML / non-text) body.
 */

import { chromium } from 'playwright';
import { DEFAULT_USER_AGENT, THRESHOLDS } from '../constants';
import { describeBlockedResponse, pickFinalMainFrameStatus, type MainFrameResponse } from '../utils/blocked-fetch';

export interface BrowserFetchResult {
  status: number;
  text: string;
}

/**
 * Navigate to `url` in a real browser and return the resolved document text.
 *
 * - For XML (sitemaps) Chromium renders the document through its built-in XML
 *   viewer; the raw markup lives in the `#webkit-xml-viewer-source-xml` node, so
 *   we read that rather than the rendered tree.
 * - For `text/plain` (robots.txt) the body is rendered inside a `<pre>`.
 *
 * @param url - URL to fetch. The caller is responsible for SSRF-gating it first.
 * @param maxBytes - Cap on the returned text length.
 */
export async function fetchTextViaBrowser(url: string, maxBytes: number): Promise<BrowserFetchResult> {
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ userAgent: DEFAULT_USER_AGENT });
    const page = await context.newPage();
    const mainFrameResponses: MainFrameResponse[] = [];
    page.on('response', (res) => {
      const code = res.status();
      if (code >= 300 && code < 400) return;
      if (res.frame() === page.mainFrame() && res.request().isNavigationRequest()) {
        mainFrameResponses.push({ status: code, headers: res.headers() });
      }
    });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: THRESHOLDS.PAGE_TIMEOUT });
    // Let any anti-bot challenge JS resolve and redirect to the real content.
    await page.waitForLoadState('networkidle', { timeout: THRESHOLDS.PAGE_TIMEOUT }).catch(() => undefined);

    const text = await page.evaluate(() => {
      const xmlSource = document.getElementById('webkit-xml-viewer-source-xml');
      if (xmlSource) return xmlSource.innerHTML;
      const pre = document.querySelector('body > pre');
      if (pre) return pre.textContent ?? '';
      return document.body ? document.body.innerText : document.documentElement.outerHTML;
    });

    const status = pickFinalMainFrameStatus(mainFrameResponses) ?? response?.status() ?? 0;
    if (status !== 200) {
      console.warn(`Browser fetch: ${describeBlockedResponse(status, response?.headers() ?? null, text, url)}`);
    }
    return { status, text: text.length > maxBytes ? text.slice(0, maxBytes) : text };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}
