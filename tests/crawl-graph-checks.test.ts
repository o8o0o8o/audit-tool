import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Issue, PageInfo } from '../lib/types';
import { SEVERITY } from '../lib/constants';
import {
  CRAWL_GRAPH_MESSAGES as M,
  checkCalendarSpaces,
  checkCanonicalChains,
  checkCanonicalTargets,
  checkCtaLinks,
  checkFacetExplosion,
  checkHreflangTargets,
  checkPhoneConsistency,
  checkSitemapLastmod,
  extractSchemaPhones,
  extractUrlYears,
  isCtaText,
  runCrawlGraphChecks,
} from '../lib/analyzers/site-wide/crawl-graph-checks';

const O = 'https://ex.com';
const pg = (url: string, extra: Partial<PageInfo> = {}): PageInfo => ({ url, status: 200, ...extra });
const rec = (...ps: PageInfo[]): Record<string, PageInfo> => Object.fromEntries(ps.map((p) => [p.url, p]));
const msgs = (issues: Issue[]) => issues.map((i) => String(i.message));

void test('canonical loop reported once, HIGH', () => {
  const issues = checkCanonicalChains(
    rec(pg(`${O}/a`, { canonical: `${O}/b` }), pg(`${O}/b`, { canonical: `${O}/a` })),
  );
  assert.deepEqual(msgs(issues), [M.canonicalLoop]);
  assert.equal(issues[0]!.severity, SEVERITY.HIGH);
});

void test('canonical chain A→B→C is MEDIUM; self canonical ignored', () => {
  const issues = checkCanonicalChains(
    rec(
      pg(`${O}/a`, { canonical: `${O}/b` }),
      pg(`${O}/b`, { canonical: `${O}/c` }),
      pg(`${O}/c`, { canonical: `${O}/c` }),
    ),
  );
  assert.deepEqual(msgs(issues), [M.canonicalChain]);
  assert.equal(issues[0]!.severity, SEVERITY.MEDIUM);
});

void test('canonical targets: redirect, error, noindex; uncrawled target ignored', () => {
  const issues = checkCanonicalTargets(
    rec(
      pg(`${O}/1`, { canonical: `${O}/r` }),
      pg(`${O}/2`, { canonical: `${O}/e` }),
      pg(`${O}/3`, { canonical: `${O}/n` }),
      pg(`${O}/4`, { canonical: `${O}/unknown` }),
      pg(`${O}/r`, { hasRedirects: true, finalUrl: `${O}/x` }),
      pg(`${O}/e`, { status: 404 }),
      pg(`${O}/n`, { metaRobots: 'noindex, follow' }),
    ),
  );
  assert.deepEqual(msgs(issues).sort(), [M.canonicalToError, M.canonicalToNoindex, M.canonicalToRedirect].sort());
});

void test('hreflang targets incl. canonicalised', () => {
  const issues = checkHreflangTargets(
    rec(
      pg(`${O}/en`, {
        alternates: [
          { hreflang: 'de', href: `${O}/de` },
          { hreflang: 'fr', href: `${O}/fr` },
          { hreflang: 'en', href: `${O}/en` },
        ],
      }),
      pg(`${O}/de`, { canonical: `${O}/de-main` }),
      pg(`${O}/fr`, { status: 500 }),
    ),
  );
  assert.deepEqual(msgs(issues).sort(), [M.hreflangToCanonicalised, M.hreflangToError].sort());
});

void test('facet explosion flags >=50 variants without canonical, skips canonicalised', () => {
  const urls = Array.from({ length: 60 }, (_, i) => `${O}/shop?color=${i}`);
  assert.deepEqual(msgs(checkFacetExplosion({}, urls, O)), [M.facetExplosion]);
  const crawled = rec(...urls.map((u) => pg(u, { canonical: `${O}/shop` })));
  assert.equal(checkFacetExplosion(crawled, [], O).length, 0);
  assert.equal(checkFacetExplosion({}, urls.slice(0, 49), O).length, 0);
});

void test('calendar spaces: future/past years, product ids ignored, large archive', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  assert.deepEqual(extractUrlYears(`${O}/product/1234`), []);
  assert.deepEqual(extractUrlYears(`${O}/events/2031`), [2031]);
  assert.deepEqual(extractUrlYears(`${O}/x?date=2040-01-01`), [2040]);
  const issues = checkCalendarSpaces([`${O}/calendar?date=2040-05-01`, `${O}/events/1980/05`], O, now);
  assert.equal(issues.filter((i) => i.message === M.calendarOutOfRange).length, 2);
  const archive = Array.from({ length: 101 }, (_, i) => `${O}/blog/${2000 + (i % 25)}/${(i % 12) + 1}`);
  assert.deepEqual(msgs(checkCalendarSpaces(archive, O, now)), [M.calendarArchiveLarge]);
});

void test('sitemap lastmod uniform and future', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const sm: Record<string, { loc: string; lastmod: string }> = {};
  for (let i = 0; i < 20; i++) sm[`${O}/${i}`] = { loc: `${O}/${i}`, lastmod: '2025-06-01' };
  sm[`${O}/f`] = { loc: `${O}/f`, lastmod: '2026-03-01' };
  assert.deepEqual(msgs(checkSitemapLastmod(sm, now)).sort(), [M.lastmodFuture, M.lastmodUniform].sort());
  assert.equal(checkSitemapLastmod({ a: { lastmod: '2026-01-01T12:00:00Z' } }, now).length, 0);
});

void test('CTA text matching (en/de/fr/es) and non-CTA', () => {
  for (const t of ['Buy now', 'Add to cart', 'Jetzt kaufen', 'Ajouter au panier', 'Comprar', 'Start free trial'])
    assert.ok(isCtaText(t), t);
  assert.ok(!isCtaText('About our team'));
  assert.ok(!isCtaText('Buyer guide'));
});

void test('CTA to error page and to login redirect, from ctas and from links input', () => {
  const pages = rec(
    pg(`${O}/`, {
      ctas: [
        {
          type: 'button',
          text: 'Buy now',
          href: '/checkout',
          rect: { top: 0, left: 0, width: 1, height: 1 },
          aboveFold: true,
        },
      ],
    }),
    pg(`${O}/checkout`, { status: 404 }),
    pg(`${O}/trial`, { hasRedirects: true, finalUrl: `${O}/account/login?next=/trial` }),
  );
  const issues = checkCtaLinks(pages, { [`${O}/`]: [{ href: `${O}/trial`, text: 'Get started' }] });
  assert.deepEqual(msgs(issues).sort(), [M.ctaToError, M.ctaToLogin].sort());
});

void test('phone consistency', () => {
  const phones = extractSchemaPhones({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'LocalBusiness', telephone: '+49 30 1234567' },
      { '@type': 'WebPage', telephone: '1' },
    ],
  });
  assert.equal(phones.length, 1);
  const ok = checkPhoneConsistency([
    { url: `${O}/`, schemaPhones: phones, visibleText: 'Call 030 / 123 45 67', telLinks: [] },
  ]);
  assert.equal(ok.length, 0);
  const viaTel = checkPhoneConsistency([
    { url: `${O}/`, schemaPhones: phones, visibleText: '', telLinks: ['tel:+49301234567'] },
  ]);
  assert.equal(viaTel.length, 0);
  const bad = checkPhoneConsistency([
    { url: `${O}/`, schemaPhones: phones, visibleText: 'Call 030 999 8888', telLinks: [] },
  ]);
  assert.deepEqual(msgs(bad), [M.phoneNotOnPage]);
  assert.equal(bad[0]!.severity, SEVERITY.LOW);
});

void test('runCrawlGraphChecks aggregates and escapes page-derived text', () => {
  const pages = rec(pg(`${O}/a`, { canonical: `${O}/b"><script>` }), pg(`${O}/b"><script>`, { status: 410 }));
  const issues = runCrawlGraphChecks(pages, {}, O, new Date('2026-01-01'));
  assert.ok(issues.length >= 1);
  assert.ok(issues.every((i) => !String(i.detail).includes('<script>')));
});

void test('message strings are distinct', () => {
  const v = Object.values(M);
  assert.equal(new Set(v).size, v.length);
});
