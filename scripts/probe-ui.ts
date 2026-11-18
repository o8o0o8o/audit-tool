/**
 * Runs the `--visual` layout checks and click probes on one or more live pages, outside a crawl,
 * and prints what they find. For trying the checks on a page and for comparing with other tools.
 *
 *   npx tsx scripts/probe-ui.ts <url> [<url> …]
 *   npx tsx scripts/probe-ui.ts file://$PWD/tests/fixtures/ui-defects/broken.html
 *   npx tsx scripts/probe-ui.ts --shots=<folder> <url>     also save the screenshots behind each finding
 *
 * It clicks what the crawl's probe clicks (menu, collapsed sections, plain buttons, site search)
 * and nothing else. Nothing is written to disk unless `--shots` names a folder.
 */

import { chromium } from 'playwright';
import { LayoutIntegrityAnalyzer } from '../lib/analyzers/visual/layout-integrity-analyzer';
import { InteractionProbe } from '../lib/analyzers/visual/interaction-probe';

const PHONE = { width: 414, height: 896 };
const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const plain = (s: string) => s.replace(/<[^>]*>/g, '');

async function main() {
  const urls = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (urls.length === 0) {
    console.error('Usage: npx tsx scripts/probe-ui.ts <url> [<url> …]');
    process.exit(1);
  }
  const shotsDir = process.argv.find((a) => a.startsWith('--shots='))?.slice('--shots='.length);
  const browser = await chromium.launch();
  let found = 0;
  for (const url of urls) {
    const context = await browser.newContext({ viewport: PHONE, userAgent: USER_AGENT });
    // tsx wraps named functions in __name(); functions sent to the page need it to exist there.
    await context.addInitScript({ content: 'window.__name = window.__name || function (f) { return f; };' });
    const page = await context.newPage();
    const started = Date.now();
    try {
      const response = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
      await page.waitForTimeout(2000);
      // Bring lazy content in, as the crawl's scroll pass does before the layout checks.
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      for (let y = 0; y < Math.min(height, 20000); y += 800) {
        await page.evaluate((to) => window.scrollTo(0, to), y);
        await page.waitForTimeout(120);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(400);

      const layout = await LayoutIntegrityAnalyzer.analyze(page, url);
      const probe = await InteractionProbe.run(page, url, shotsDir);
      const issues = [...layout.issues, ...probe.issues];
      found += issues.length;
      console.log(`\n${url}  (HTTP ${response?.status() ?? '?'}, ${Math.round((Date.now() - started) / 1000)}s)`);
      for (const issue of issues)
        console.log(`  [${issue.severity}] ${issue.message}\n      ${plain(issue.detail ?? '')}`);
      if (issues.length === 0) console.log('  no layout or interaction findings');
      for (const shot of probe.shots ?? [])
        console.log(`  screenshot: ${shotsDir}/${shot.file.replace(/^evidence\//, '')}`);
      const clicked = probe.probed.map((p) => `${p.kind} ${p.name} → ${p.responded ? 'responded' : 'no response'}`);
      console.log(`  clicked: ${clicked.join('; ') || 'nothing to click was found'}`);
    } catch (error) {
      console.log(`\n${url}\n  could not be checked: ${(error as Error).message.split('\n')[0]}`);
    }
    await context.close();
  }
  await browser.close();
  console.log(`\n${found} finding(s) on ${urls.length} page(s).`);
}

void main();
