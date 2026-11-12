import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'node-html-parser';
import { extractHeadLinks } from '../lib/crawler/page-data-builder';
import { PWAAnalyzer } from '../lib/analyzers/performance/pwa-analyzer';
import {
  checkFavicon,
  checkManifest,
  type FetchLike,
} from '../lib/analyzers/performance/favicon-manifest-validator';
import { classifyIssue } from '../lib/scoring/seo-catalog';
import { EXTENDED_FIX_RECOMMENDATIONS } from '../lib/scoring/fix-recommendations-extended';
import { checkFindingSignals, type LiveSignals } from '../lib/phase3/live-verifier';
import { getIssuesDetail } from '../lib/reports/sections/issues-detail';
import type { PageInfo, ReportSectionData } from '../lib/types';

const ORIGIN = 'https://example.com';

function png(size: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const v = new DataView(b.buffer);
  v.setUint32(16, size);
  v.setUint32(20, size);
  return b;
}

function ico(...sizes: number[]): Uint8Array {
  const b = new Uint8Array(6 + sizes.length * 16);
  b.set([0, 0, 1, 0, sizes.length, 0]);
  sizes.forEach((s, i) => {
    b[6 + i * 16] = s % 256;
    b[7 + i * 16] = s % 256;
  });
  return b;
}

type Route = { status: number; type?: string; body?: Uint8Array | string; location?: string } | 'timeout';

/** Mock fetch keyed by `METHOD url` or plain `url` (any method). Unknown URLs return 404. */
function mockFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const impl: FetchLike = (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const route = routes[`${method} ${url}`] ?? routes[url] ?? { status: 404, type: 'text/html' };
    if (route === 'timeout') return Promise.reject(new DOMException('timed out', 'TimeoutError'));
    const headers: Record<string, string> = {};
    if (route.type) headers['content-type'] = route.type;
    if (route.location) headers.location = route.location;
    const body = method === 'HEAD' || route.location ? null : (route.body ?? '');
    return Promise.resolve(new Response(body as BodyInit | null, { status: route.status, headers }));
  };
  return { impl, calls };
}

/** Pages from the current crawl: `icons` is always set (empty when the page has none). */
function pagesWith(...pages: Partial<PageInfo>[]): Record<string, PageInfo> {
  return Object.fromEntries(
    pages.map((p, i) => [`${ORIGIN}/p${i}`, { url: `${ORIGIN}/p${i}`, icons: [], ...p } as PageInfo]),
  );
}

/** Pages restored from a checkpoint written before head links were captured (no `icons`). */
function legacyPages(count: number): Record<string, PageInfo> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`${ORIGIN}/p${i}`, { url: `${ORIGIN}/p${i}` } as PageInfo]),
  );
}

const icon = (href: string, sizes?: string) => ({ pages: pagesWith({ icons: [{ href, rel: 'icon', sizes }] }) });

void describe('head links fill PWA fields', () => {
  void it('head links fill PWA fields and silence missing-manifest/theme-color warnings', () => {
    const doc = parse(`<html><head>
      <link rel="manifest" href="/site.webmanifest">
      <link rel="icon" href="img/fav.png" sizes="32x32" type="image/png">
      <link rel="apple-touch-icon" href="/apple.png">
      <link rel="icon" href="data:image/png;base64,AAAA">
      <meta name="theme-color" content="#00E56D">
    </head><body></body></html>`);
    const page = { url: `${ORIGIN}/blog/post` } as PageInfo;
    extractHeadLinks(doc, page.url!, page);

    assert.equal(page.manifest, `${ORIGIN}/site.webmanifest`);
    assert.equal(page.appleTouchIcon, `${ORIGIN}/apple.png`);
    assert.equal(page.themeColor, '#00E56D');
    assert.deepEqual(page.icons?.[0], { href: `${ORIGIN}/blog/img/fav.png`, sizes: '32x32', type: 'image/png', rel: 'icon' });
    assert.ok(page.icons?.some((i) => i.href?.startsWith('data:')));

    const perPage = PWAAnalyzer.analyze(page, page.url!);
    const messages = perPage.warnings.map((w) => w.message);
    assert.ok(!messages.includes('No web app manifest'));
    assert.ok(!messages.includes('No theme-color meta tag'));
    assert.ok(!messages.includes('No Apple touch icon'));

    const site = PWAAnalyzer.analyzeSiteWide({ [page.url!]: page });
    assert.ok(!site.warnings.some((w) => w.message === 'No web app manifest found on any page'));
    assert.equal(site.stats.pagesWithThemeColor, 1);
  });

  void it('head links: theme-color is read from metaMap', () => {
    const page = { url: ORIGIN, metaMap: { 'theme-color': '#fff' } } as unknown as PageInfo;
    const { warnings } = PWAAnalyzer.analyze(page, ORIGIN);
    assert.ok(!warnings.some((w) => w.message === 'No theme-color meta tag'));
  });
});

void describe('favicon check', () => {
  const messages = (r: { issues: { message?: string }[]; warnings: { message?: string }[] }) =>
    [...r.issues, ...r.warnings].map((i) => i.message);

  void it('favicon check: no icon link and /favicon.ico 404 → Favicon missing (MEDIUM)', async () => {
    const { impl } = mockFetch({});
    const r = await checkFavicon(pagesWith({}), ORIGIN, { fetchImpl: impl });
    assert.deepEqual(messages(r), ['Favicon missing']);
    assert.equal(r.issues[0].severity, 'medium');
  });

  void it('favicon check: /favicon.ico 500 or 200 text/html is flagged', async () => {
    for (const route of [{ status: 500 }, { status: 200, type: 'text/html; charset=utf-8', body: '<html>' }]) {
      const { impl } = mockFetch({ [`${ORIGIN}/favicon.ico`]: route });
      const r = await checkFavicon(pagesWith({}), ORIGIN, { fetchImpl: impl });
      assert.deepEqual(messages(r), ['Favicon missing']);
    }
  });

  void it('favicon check: /favicon.ico served as an icon is silent', async () => {
    const { impl } = mockFetch({ [`${ORIGIN}/favicon.ico`]: { status: 200, type: 'image/x-icon', body: ico(48) } });
    assert.deepEqual(messages(await checkFavicon(pagesWith({}), ORIGIN, { fetchImpl: impl })), []);
  });

  void it('favicon check: timed-out or blocked /favicon.ico is silent', async () => {
    const { impl } = mockFetch({ [`${ORIGIN}/favicon.ico`]: 'timeout' });
    assert.deepEqual(messages(await checkFavicon(pagesWith({}), ORIGIN, { fetchImpl: impl })), []);
    const blocked = mockFetch({});
    const { pages } = icon('http://10.0.0.1/fav.png');
    assert.deepEqual(messages(await checkFavicon(pages, ORIGIN, { fetchImpl: blocked.impl })), []);
    assert.deepEqual(blocked.calls.filter((c) => c.includes('10.0.0.1/fav')), []);
  });

  void it('favicon check: redirect to a private address is not followed and is silent', async () => {
    const { impl, calls } = mockFetch({
      [`${ORIGIN}/fav.png`]: { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
    });
    const r = await checkFavicon(icon(`${ORIGIN}/fav.png`).pages, ORIGIN, { fetchImpl: impl });
    assert.deepEqual(messages(r), []);
    assert.deepEqual(calls.filter((c) => c.includes('169.254')), []);
  });

  void it('favicon check: same-site redirect is followed per hop', async () => {
    const { impl } = mockFetch({
      [`${ORIGIN}/fav.png`]: { status: 301, location: '/img/fav.png' },
      [`${ORIGIN}/img/fav.png`]: { status: 200, type: 'image/png', body: png(64) },
    });
    assert.deepEqual(messages(await checkFavicon(icon(`${ORIGIN}/fav.png`).pages, ORIGIN, { fetchImpl: impl })), []);
  });

  void it('favicon check: icon returning 404 → Favicon returns error status (MEDIUM)', async () => {
    const { impl } = mockFetch({});
    const r = await checkFavicon(icon(`${ORIGIN}/fav.png`).pages, ORIGIN, { fetchImpl: impl });
    assert.deepEqual(messages(r), ['Favicon returns error status']);
    assert.equal(r.issues[0].severity, 'medium');
  });

  void it('favicon check: icon served as text/html → Favicon is not an image', async () => {
    const { impl } = mockFetch({ [`${ORIGIN}/fav.png`]: { status: 200, type: 'text/html', body: '<html>' } });
    const r = await checkFavicon(icon(`${ORIGIN}/fav.png`).pages, ORIGIN, { fetchImpl: impl });
    assert.deepEqual(messages(r), ['Favicon is not an image']);
  });

  void it('favicon check: 16×16 PNG → Favicon smaller than 48px (LOW)', async () => {
    const { impl } = mockFetch({ [`${ORIGIN}/fav.png`]: { status: 200, type: 'image/png', body: png(16) } });
    const r = await checkFavicon(icon(`${ORIGIN}/fav.png`).pages, ORIGIN, { fetchImpl: impl });
    assert.deepEqual(messages(r), ['Favicon smaller than 48px']);
    assert.equal(r.warnings[0].severity, 'low');
  });

  void it('favicon check: 64×64 PNG, ICO with a 64px entry, data: icon and timeout are silent', async () => {
    const { impl } = mockFetch({
      [`${ORIGIN}/a.png`]: { status: 200, type: 'image/png', body: png(64) },
      [`${ORIGIN}/b.ico`]: { status: 200, type: 'image/x-icon', body: ico(16, 64) },
      [`${ORIGIN}/slow.png`]: 'timeout',
    });
    for (const href of [`${ORIGIN}/a.png`, `${ORIGIN}/b.ico`, 'data:image/png;base64,AAAA', `${ORIGIN}/slow.png`]) {
      assert.deepEqual(messages(await checkFavicon(icon(href).pages, ORIGIN, { fetchImpl: impl })), [], href);
    }
  });
});

void describe('manifest check', () => {
  const manifestPages = (url: string, n = 1) => pagesWith(...Array.from({ length: n }, () => ({ manifest: url })));

  void it('manifest check: fetches the manifest once for many pages and flags a 404 manifest (MEDIUM)', async () => {
    const { impl, calls } = mockFetch({});
    const r = await checkManifest(manifestPages(`${ORIGIN}/m.json`, 5), ORIGIN, { fetchImpl: impl });
    assert.deepEqual(r.issues.map((i) => i.message), ['Web manifest failed to load']);
    assert.equal(r.issues[0].severity, 'medium');
    assert.equal(calls.length, 1);
  });

  void it('manifest check: invalid JSON → Invalid manifest JSON', async () => {
    const { impl } = mockFetch({ [`${ORIGIN}/m.json`]: { status: 200, type: 'application/json', body: '{oops' } });
    const r = await checkManifest(manifestPages(`${ORIGIN}/m.json`), ORIGIN, { fetchImpl: impl });
    assert.deepEqual(r.issues.map((i) => i.message), ['Invalid manifest JSON']);
    assert.equal(r.issues[0].severity, 'medium');
  });

  void it('manifest check: valid but sparse manifest yields no content findings', async () => {
    const { impl } = mockFetch({ [`${ORIGIN}/m.json`]: { status: 200, type: 'application/json', body: '{}' } });
    const r = await checkManifest(manifestPages(`${ORIGIN}/m.json`), ORIGIN, { fetchImpl: impl });
    assert.deepEqual(r.issues, []);
    assert.deepEqual(r.warnings, []);
  });

  void it('manifest check: relative icon resolves against a subpath manifest; 404 icon flagged', async () => {
    const manifest = JSON.stringify({ name: 'x', icons: [{ src: 'icons/a.png', sizes: '192x192' }] });
    const { impl, calls } = mockFetch({ [`${ORIGIN}/app/manifest.json`]: { status: 200, body: manifest } });
    const r = await checkManifest(manifestPages(`${ORIGIN}/app/manifest.json`), ORIGIN, { fetchImpl: impl });
    assert.ok(calls.includes(`HEAD ${ORIGIN}/app/icons/a.png`));
    const broken = r.issues.filter((i) => i.message === 'Manifest icon returns 404');
    assert.equal(broken.length, 1);
    assert.equal(broken[0].severity, 'medium');
  });

  void it('manifest check: HEAD 405 falls back to GET before flagging', async () => {
    const manifest = JSON.stringify({ icons: [{ src: '/i.png' }] });
    const { impl, calls } = mockFetch({
      [`${ORIGIN}/m.json`]: { status: 200, body: manifest },
      [`HEAD ${ORIGIN}/i.png`]: { status: 405 },
      [`GET ${ORIGIN}/i.png`]: { status: 200, type: 'image/png', body: png(192) },
    });
    const r = await checkManifest(manifestPages(`${ORIGIN}/m.json`), ORIGIN, { fetchImpl: impl });
    assert.ok(calls.includes(`GET ${ORIGIN}/i.png`));
    assert.ok(!r.issues.some((i) => i.message === 'Manifest icon returns 404'));
  });

  void it('manifest check: data:, blocked and timed-out icons and manifests yield no finding', async () => {
    const manifest = JSON.stringify({
      icons: [{ src: 'data:image/png;base64,AAAA' }, { src: 'http://10.0.0.1/i.png' }, { src: '/slow.png' }],
    });
    const { impl, calls } = mockFetch({
      [`${ORIGIN}/m.json`]: { status: 200, body: manifest },
      [`${ORIGIN}/slow.png`]: 'timeout',
      [`${ORIGIN}/slow.json`]: 'timeout',
    });
    const r = await checkManifest(manifestPages(`${ORIGIN}/m.json`), ORIGIN, { fetchImpl: impl });
    assert.ok(!r.issues.some((i) => i.message === 'Manifest icon returns 404'));
    assert.ok(!calls.some((c) => c.includes('10.0.0.1') || c.includes('data:')));

    for (const url of [`${ORIGIN}/slow.json`, 'http://10.0.0.1/m.json']) {
      const res = await checkManifest(manifestPages(url), ORIGIN, { fetchImpl: impl });
      assert.deepEqual(res.issues, [], url);
    }
  });
});

void describe('favicon manifest routing', () => {
  const broken = [
    'Favicon missing',
    'Favicon returns error status',
    'Favicon is not an image',
    'Web manifest failed to load',
    'Invalid manifest JSON',
    'Manifest icon returns 404',
  ];

  void it('favicon manifest routing: broken titles are warning tier with fix recs and own live checkers', () => {
    const signals = { hasManifestLink: true, hasIconLink: false } as LiveSignals;
    for (const title of broken) {
      assert.notEqual(classifyIssue(title, 'medium').tier, 'notice', title);
      assert.ok(EXTENDED_FIX_RECOMMENDATIONS[title], `fix rec for ${title}`);
      // pwa-manifest would refute on hasManifestLink; the dedicated checkers never refute these.
      const verdict = checkFindingSignals(title, signals);
      assert.equal(verdict.status, 'unverified', title);
      assert.doesNotMatch(verdict.reason, /no live checker/, title);
    }
    assert.ok(EXTENDED_FIX_RECOMMENDATIONS['Favicon smaller than 48px']);
    assert.equal(checkFindingSignals('Favicon missing', { hasIconLink: true } as LiveSignals).status, 'refuted');
  });

  void it('favicon manifest routing: HTML report renders the favicon issue as medium', () => {
    const data: ReportSectionData = {
      jsonData: {
        analysis: {
          details: {
            'Favicon returns error status': { severity: 'medium', count: 1, examples: [`${ORIGIN}/fav.png`] },
          },
        },
      },
      pages: [],
      pageData: {} as ReportSectionData['pageData'],
    };
    const html = getIssuesDetail(data);
    const row = /<tr class="issues-table-row"[^>]*>/.exec(html)?.[0] ?? '';
    assert.match(html, /Favicon returns error status/);
    assert.match(row, /data-severity="medium"/);
  });
});

void describe('favicon/manifest on resume from an older checkpoint', () => {
  void it('reads icon links from the homepage instead of reporting a false "Favicon missing"', async () => {
    const { impl, calls } = mockFetch({
      [`${ORIGIN}/`]: {
        status: 200,
        type: 'text/html',
        body: '<html><head><link rel="icon" href="/static/icon.png"><link rel="manifest" href="/site.webmanifest"></head></html>',
      },
      [`${ORIGIN}/static/icon.png`]: { status: 200, type: 'image/png', body: png(64) },
      [`${ORIGIN}/site.webmanifest`]: { status: 404, type: 'text/html' },
    });
    const pages = legacyPages(3);
    const fav = await checkFavicon(pages, ORIGIN, { fetchImpl: impl });
    assert.deepEqual([...fav.issues, ...fav.warnings].map((i) => i.message), []);
    assert.ok(!calls.some((c) => c.includes('/favicon.ico')));
    const man = await checkManifest(pages, ORIGIN, { fetchImpl: impl });
    assert.deepEqual(man.issues.map((i) => i.message), ['Web manifest failed to load']);
  });

  void it('gives no "Favicon missing" when the homepage cannot be read', async () => {
    const { impl } = mockFetch({ [`${ORIGIN}/`]: 'timeout' });
    const res = await checkFavicon(legacyPages(2), ORIGIN, { fetchImpl: impl });
    assert.deepEqual(res.issues, []);
  });

  void it('still reports "Favicon missing" when the homepage has no icon link and /favicon.ico is 404', async () => {
    const { impl } = mockFetch({ [`${ORIGIN}/`]: { status: 200, type: 'text/html', body: '<html><head></head></html>' } });
    const res = await checkFavicon(legacyPages(2), ORIGIN, { fetchImpl: impl });
    assert.deepEqual(res.issues.map((i) => i.message), ['Favicon missing']);
  });
});
