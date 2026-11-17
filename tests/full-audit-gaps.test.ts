import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PageInfo } from '../lib/types';
import { LinkStructureAnalyzer } from '../lib/analyzers/site-wide/link-structure-analyzer';
import { PaginationAnalyzer } from '../lib/analyzers/seo/pagination-analyzer';
import { InternationalSEOValidator, declaredLanguages } from '../lib/analyzers/site-wide/international-seo-validator';
import { evenSample, probeUncrawledSitemapUrls } from '../lib/orchestrators/sitemap-url-probe';

const page = (url: string, over: Record<string, unknown> = {}) => ({ url, status: 200, ...over }) as unknown as PageInfo;

void describe('internal links to a missing page', () => {
  void it('reports a crawled 404 linked from pages that loaded, grouped by path', () => {
    const pages = {
      'https://ex.com/': page('https://ex.com/'),
      'https://ex.com/a': page('https://ex.com/a'),
      'https://ex.com/app': page('https://ex.com/app', { status: 404 }),
      'https://ex.com/locale?p=%2F': page('https://ex.com/locale?p=%2F', { status: 404 }),
      'https://ex.com/locale?p=%2Fa': page('https://ex.com/locale?p=%2Fa', { status: 404 }),
      'https://ex.com/orphan-404': page('https://ex.com/orphan-404', { status: 404 }),
    };
    const incoming = {
      'https://ex.com/app': ['https://ex.com/', 'https://ex.com/a'],
      'https://ex.com/locale?p=%2F': ['https://ex.com/'],
      'https://ex.com/locale?p=%2Fa': ['https://ex.com/a'],
    };
    const issues = LinkStructureAnalyzer.linksToMissingPages(pages, incoming);
    assert.equal(issues.length, 2);
    assert.ok(issues.every((i) => i.message === 'Internal links point to a missing page'));
    assert.match(issues[0].detail ?? '', /\/app.*HTTP 404.*2 crawled page/);
    assert.match(issues[1].detail ?? '', /2 query-string variants/);
  });

  void it('ignores a 404 linked only from other error pages', () => {
    const pages = { 'https://ex.com/x': page('https://ex.com/x', { status: 404 }), 'https://ex.com/y': page('https://ex.com/y', { status: 404 }) };
    assert.equal(LinkStructureAnalyzer.linksToMissingPages(pages, { 'https://ex.com/x': ['https://ex.com/y'] }).length, 0);
  });
});

void describe('pagination: a trailing year is not a page number', () => {
  void it('reads /draft/2026 and /archive/1999/ as not paginated', () => {
    assert.equal(PaginationAnalyzer.analyzeUrlPagination('https://ex.com/draft/2026').isPaginated, false);
    assert.equal(PaginationAnalyzer.analyzeUrlPagination('https://ex.com/archive/1999/').isPaginated, false);
  });
  void it('still reads small trailing numbers and explicit patterns', () => {
    assert.equal(PaginationAnalyzer.analyzeUrlPagination('https://ex.com/list/2').currentPage, 2);
    assert.equal(PaginationAnalyzer.analyzeUrlPagination('https://ex.com/page/2026').currentPage, 2026);
  });
});

void describe('multilanguage without hreflang', () => {
  const intl = (lang: string) => ({ langAttribute: lang, language: lang, hasHreflang: false });
  const pages = {
    'https://ex.com/en/a': page('https://ex.com/en/a', { internationalSEO: intl('en-CA') }),
    'https://ex.com/en/b': page('https://ex.com/en/b', { internationalSEO: intl('en-CA') }),
    'https://ex.com/fr/a': page('https://ex.com/fr/a', { internationalSEO: intl('fr-CA') }),
    'https://ex.com/fr/b': page('https://ex.com/fr/b', { internationalSEO: intl('fr') }),
  };
  void it('reads languages from <html lang>, each on two pages or more', () => {
    assert.deepEqual(declaredLanguages(pages), ['en', 'fr']);
    const oneStray = { ...pages, 'https://ex.com/de': page('https://ex.com/de', { internationalSEO: intl('de') }) };
    assert.deepEqual(declaredLanguages(oneStray), ['en', 'fr']);
  });
  void it('reports the missing hreflang although hreflang-based detection said one language', () => {
    const r = InternationalSEOValidator.validateInternationalSEOConsistency(pages, false);
    assert.ok(r.issues.some((i) => i.message === 'Multilanguage site has no hreflang'));
  });
  void it('still skips a site in one language', () => {
    const en = { 'https://ex.com/a': pages['https://ex.com/en/a'], 'https://ex.com/b': pages['https://ex.com/en/b'] };
    assert.equal(InternationalSEOValidator.validateInternationalSEOConsistency(en, false).issues.length, 0);
  });
});

void describe('uncrawled sitemap URL probe', () => {
  const fake = (statuses: Record<string, { head: number; get: number }>) => async (url: string, _t: number, init?: RequestInit) =>
    new Response(null, { status: init?.method === 'HEAD' ? statuses[url].head : statuses[url].get });

  void it('counts a 404 only when the GET confirms it', async () => {
    const r = await probeUncrawledSitemapUrls(
      ['https://ex.com/gone', 'https://ex.com/head-only', 'https://ex.com/ok', 'https://ex.com/blocked'],
      'https://ex.com',
      fake({
        'https://ex.com/gone': { head: 404, get: 404 },
        'https://ex.com/head-only': { head: 404, get: 200 },
        'https://ex.com/ok': { head: 200, get: 200 },
        'https://ex.com/blocked': { head: 403, get: 403 },
      }),
    );
    assert.equal(r.checked, 4);
    assert.deepEqual([...r.missing], [['https://ex.com/gone', 404]]);
  });

  void it('samples evenly across the list', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const s = evenSample(items, 10);
    assert.equal(s.length, 10);
    assert.equal(s[0], 0);
    assert.equal(s[9], 90);
  });
});
