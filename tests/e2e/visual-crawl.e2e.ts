/**
 * Live end-to-end check for the visual check family (needs Chromium).
 *
 * Serves tests/fixtures/visual-page, runs a real crawl via start.ts against it,
 * then asserts the `/` page's issues contain the broken-image, upscaled-image and
 * template-token messages and that no analyzer timed out.
 *
 * Run: node --import tsx tests/e2e/visual-crawl.e2e.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '..', '..');
const port = Number(process.env.VISUAL_E2E_PORT) || 4178;
const origin = `http://localhost:${port}`;
const resultsRoot = join(root, 'audit-results');

const EXPECTED = [
  'Broken images detected',
  'Images upscaled beyond natural resolution',
  'Unrendered template tokens in page text',
];

function waitForServer(child: ChildProcess): Promise<void> {
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('fixture server did not start')), 15_000);
    child.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes('visual-page fixture on')) {
        clearTimeout(timer);
        ok();
      }
    });
    child.on('exit', (code) => fail(new Error(`fixture server exited ${code}`)));
  });
}

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((ok) => {
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', env: process.env });
    child.on('exit', (code) => ok(code ?? 1));
  });
}

function readJson(file: string): unknown {
  const buf = readFileSync(file);
  return JSON.parse((file.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8'));
}

/** Newest run directory (one holding pages/) created after `since`. */
function findRunDir(since: number): string | undefined {
  if (!existsSync(resultsRoot)) return undefined;
  let best: { dir: string; mtime: number } | undefined;
  for (const domain of readdirSync(resultsRoot)) {
    const domainDir = join(resultsRoot, domain);
    if (!domain.includes('localhost') || !statSync(domainDir).isDirectory()) continue;
    for (const run of readdirSync(domainDir)) {
      const dir = join(domainDir, run);
      if (!existsSync(join(dir, 'pages'))) continue;
      const mtime = statSync(dir).mtimeMs;
      if (mtime >= since && (!best || mtime > best.mtime)) best = { dir, mtime };
    }
  }
  return best?.dir;
}

function collectMessages(node: unknown, out: string[]): void {
  if (Array.isArray(node)) node.forEach((n) => collectMessages(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'message' || k === 'error') && typeof v === 'string') out.push(v);
      else collectMessages(v, out);
    }
  }
}

/** Find the page object for `/` in a batch file's data, wherever pages are keyed. */
function findRootPage(node: unknown): unknown {
  if (!node || typeof node !== 'object') return undefined;
  for (const [k, v] of Object.entries(node)) {
    if (k === `${origin}/` || k === origin) return v;
    const found = findRootPage(v);
    if (found) return found;
  }
  return undefined;
}

async function main(): Promise<void> {
  const since = Date.now() - 1000;
  const server = spawn(process.execPath, [join(root, 'tests/fixtures/visual-page/serve.mjs')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    await waitForServer(server);
    const code = await run(process.execPath, ['--import', 'tsx', 'start.ts', `--origin=${origin}`, '--no-phase2']);
    if (code !== 0) throw new Error(`crawl exited ${code}`);

    const runDir = findRunDir(since);
    if (!runDir) throw new Error(`no audit run found under ${resultsRoot}`);
    const pagesDir = join(runDir, 'pages');
    let page: unknown;
    for (const f of readdirSync(pagesDir)) {
      page = findRootPage(readJson(join(pagesDir, f)));
      if (page) break;
    }
    if (!page) throw new Error(`page ${origin}/ not found in ${pagesDir}`);

    const messages: string[] = [];
    collectMessages(page, messages);
    const missing = EXPECTED.filter((m) => !messages.some((s) => s.includes(m)));
    const timeouts = messages.filter((s) => /timed? ?out/i.test(s));
    if (missing.length || timeouts.length) {
      console.error('Messages on /:', messages);
      if (missing.length) console.error('Missing:', missing);
      if (timeouts.length) console.error('Analyzer timeouts:', timeouts);
      process.exitCode = 1;
      return;
    }
    console.log(`OK — ${origin}/ reports: ${EXPECTED.join('; ')}`);
  } finally {
    server.kill();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
