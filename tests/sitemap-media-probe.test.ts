import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'node-html-parser';
import { probeSitemapMedia, SITEMAP_MEDIA_PROBE_TITLES } from '../lib/orchestrators/sitemap-media-probe';
import { SitemapParser, SITEMAP_EXTENSION_TITLES } from '../lib/parsers/sitemap-parser';
import { ISSUE_CATALOG } from '../lib/scoring/seo-catalog';

type Call = { url: string; method: string };
type Finding = { message: string; detail: string; severity: string };

function stubFetch(statusFor: (url: string, method: string) => number | Error | { status: number; location: string }) {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchFn = async (url: string, _timeout: number, options: RequestInit = {}) => {
    const method = options.method ?? 'GET';
    calls.push({ url, method });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight--;
    const outcome = statusFor(url, method);
    if (outcome instanceof Error) throw outcome;
    if (typeof outcome === 'number') return new Response(null, { status: outcome });
    return new Response(null, { status: outcome.status, headers: { location: outcome.location } });
  };
  return { fetchFn, calls, maxInFlight: () => maxInFlight };
}

function collect() {
  const findings: Finding[] = [];
  return { findings, saveError: (message: string, detail: string, severity: string) => findings.push({ message, detail, severity }) };
}

const ORIGIN = 'https://example.com';

void describe('sitemap media probe', () => {
  void it('dedups, caps at 50 and runs at most 5 requests at a time', async () => {
    const images = Array.from({ length: 80 }, (_, i) => `https://cdn.example.com/${i}.jpg`);
    const media = { 'https://example.com/a': { images, videos: [] }, 'https://example.com/b': { images, videos: [] } };
    const stub = stubFetch(() => 200);
    const { findings, saveError } = collect();
    await probeSitemapMedia(media, ORIGIN, saveError, stub.fetchFn);
    assert.strictEqual(new Set(stub.calls.map((c) => c.url)).size, 50);
    assert.strictEqual(stub.calls.length, 50);
    assert.ok(stub.maxInFlight() <= 5);
    assert.deepStrictEqual(findings, []);
  });

  void it('falls back to GET when HEAD is not supported', async () => {
    const stub = stubFetch((_url, method) => (method === 'HEAD' ? 405 : 404));
    const { findings, saveError } = collect();
    await probeSitemapMedia({ p: { images: ['https://cdn.example.com/x.jpg'], videos: [] } }, ORIGIN, saveError, stub.fetchFn);
    assert.deepStrictEqual(
      stub.calls.map((c) => c.method),
      ['HEAD', 'GET'],
    );
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].message, SITEMAP_MEDIA_PROBE_TITLES.image);
    assert.match(findings[0].detail, /checked 1 of 1/);
  });

  void it('skips private hosts', async () => {
    const stub = stubFetch(() => 404);
    const { findings, saveError } = collect();
    await probeSitemapMedia({ p: { images: ['http://127.0.0.1/x.jpg'], videos: [] } }, ORIGIN, saveError, stub.fetchFn);
    assert.strictEqual(stub.calls.length, 0);
    assert.deepStrictEqual(findings, []);
  });

  void it('groups failures by media kind and status bucket', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('gone')) return 404;
      if (url.includes('err')) return 503;
      return new Error('ECONNRESET');
    });
    const { findings, saveError } = collect();
    await probeSitemapMedia(
      {
        p: {
          images: ['https://cdn.example.com/gone1.jpg', 'https://cdn.example.com/gone2.jpg', 'https://cdn.example.com/err.jpg'],
          videos: ['https://cdn.example.com/down.mp4'],
        },
      },
      ORIGIN,
      saveError,
      stub.fetchFn,
    );
    assert.strictEqual(findings.length, 3);
    const image4xx = findings.find((f) => f.message === SITEMAP_MEDIA_PROBE_TITLES.image && /4xx/.test(f.detail));
    assert.match(image4xx?.detail ?? '', /^2 image URL/);
    assert.ok(findings.some((f) => f.message === SITEMAP_MEDIA_PROBE_TITLES.image && /5xx/.test(f.detail)));
    assert.ok(findings.some((f) => f.message === SITEMAP_MEDIA_PROBE_TITLES.video && /unreachable/.test(f.detail)));
    // unreachable is retried once: HEAD+GET per attempt
    assert.strictEqual(stub.calls.filter((c) => c.url.includes('down')).length, 4);
  });

  void it('does not report a redirect that ends in 200', async () => {
    const stub = stubFetch((url) =>
      url.endsWith('old.jpg') ? { status: 301, location: 'https://cdn2.example.com/new.jpg' } : 200,
    );
    const { findings, saveError } = collect();
    await probeSitemapMedia({ p: { images: ['https://cdn.example.com/old.jpg'], videos: [] } }, ORIGIN, saveError, stub.fetchFn);
    assert.deepStrictEqual(findings, []);
    assert.deepStrictEqual(
      stub.calls.map((c) => c.url),
      ['https://cdn.example.com/old.jpg', 'https://cdn2.example.com/new.jpg'],
    );
  });

  void it('counts 401/403/429 as blocked, never as failed', async () => {
    const stub = stubFetch((url) => (url.includes('403') ? 403 : url.includes('429') ? 429 : 404));
    const { findings, saveError } = collect();
    await probeSitemapMedia(
      {
        p: {
          images: ['https://cdn.example.com/403.jpg', 'https://cdn.example.com/429.jpg', 'https://cdn.example.com/404.jpg'],
          videos: [],
        },
      },
      ORIGIN,
      saveError,
      stub.fetchFn,
    );
    assert.strictEqual(findings.length, 1);
    assert.match(findings[0].detail, /2 blocked/);
    assert.doesNotMatch(findings[0].detail, /403\.jpg|429\.jpg/);
  });

  void it('does not fetch relative media URLs and persists counts only', async () => {
    const urls = parse(
      '<urlset xmlns:image="i"><url><loc>https://example.com/a</loc>' +
        '<image:image><image:loc>/rel.jpg</image:loc></image:image></url></urlset>',
    ).querySelectorAll('url');
    const result = { sitemaps: {}, urls: {}, total: 0, errors: [] as Finding[] } as unknown as Parameters<
      typeof SitemapParser.processSitemap
    >[3];
    SitemapParser.processSitemap(
      urls as unknown as Parameters<typeof SitemapParser.processSitemap>[0],
      ORIGIN,
      `${ORIGIN}/sitemap.xml`,
      result,
    );
    assert.ok(result.errors.some((e) => e.message === 'Sitemap media URLs are not absolute'));
    assert.deepStrictEqual(result.urls['https://example.com/a'], { loc: 'https://example.com/a', lastmod: undefined, changefreq: undefined, priority: undefined, imageCount: 1 });

    const stub = stubFetch(() => 200);
    await probeSitemapMedia(result.media, ORIGIN, () => undefined, stub.fetchFn);
    assert.strictEqual(stub.calls.length, 0);
  });

  void it('is not called by parseSitemaps or the competitor crawl', () => {
    const root = path.join(__dirname, '..');
    const parser = fs.readFileSync(path.join(root, 'lib/parsers/sitemap-parser.ts'), 'utf8');
    assert.doesNotMatch(parser, /probeSitemapMedia|sitemap-media-probe/);
    const competitor = execGrep(root, 'competitor-crawl.ts');
    assert.ok(competitor.length > 0, 'competitor-crawl.ts not found');
    for (const file of competitor) {
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /probeSitemapMedia|sitemap-media-probe/);
    }
  });

  void it('every emitted title is cataloged', () => {
    for (const title of [...SITEMAP_EXTENSION_TITLES, ...Object.values(SITEMAP_MEDIA_PROBE_TITLES)]) {
      assert.ok(title in ISSUE_CATALOG, `missing from seo-catalog: ${title}`);
    }
  });
});

function execGrep(root: string, name: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === name) found.push(full);
    }
  };
  walk(path.join(root, 'lib'));
  return found;
}
