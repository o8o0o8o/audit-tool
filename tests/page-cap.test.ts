import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PAGE_CAP,
  fullAuditPageBudget,
  orderForCoverage,
  resolvePageCap,
  sitemapShare,
  templateCounts,
} from '../lib/crawler/page-cap';
import { crawlPageBudget } from '../lib/seo-data';
import { parseArgs } from '../lib/args-parser';
import { templateKey } from '../lib/leads/page-selector';

const site = (): string[] => {
  const urls = ['https://x.test/'];
  for (let i = 0; i < 900; i++) urls.push(`https://x.test/products/p-${i}`);
  for (let i = 0; i < 90; i++) urls.push(`https://x.test/blog/${2020 + (i % 3)}/post-${i}`);
  for (let i = 0; i < 6; i++) urls.push(`https://x.test/de/blog/2020/beitrag-${i}`);
  for (const p of ['pricing', 'about', 'contact']) urls.push(`https://x.test/${p}`);
  return urls;
};

void describe('page cap', () => {
  void it('defaults to 5000 for a full audit, and is off for lead scans, single pages and 0', () => {
    assert.equal(resolvePageCap(null, false, false), DEFAULT_PAGE_CAP);
    assert.equal(resolvePageCap(200, false, false), 200);
    assert.equal(resolvePageCap(0, false, false), null);
    assert.equal(resolvePageCap(null, true, false), null);
    assert.equal(resolvePageCap(null, false, true), null);
  });

  void it('bounds the page budget together with --limit', () => {
    assert.equal(fullAuditPageBudget(null, 5000), 5000);
    assert.equal(fullAuditPageBudget(150, 5000), 300);
    assert.equal(fullAuditPageBudget(4000, 5000), 5000);
    assert.equal(fullAuditPageBudget(null, null), null);
    assert.equal(crawlPageBudget(25, true, null), 25);
    assert.equal(sitemapShare(5000), 4500);
  });

  void it('takes the homepage first and one page of every template before a second of any', () => {
    const ordered = orderForCoverage(site(), { home: 'https://x.test' });
    assert.equal(ordered.length, site().length);
    assert.equal(ordered[0], 'https://x.test/');
    const first = new Set(ordered.slice(0, 6).map((u) => templateKey(u)));
    assert.deepEqual([...first].sort(), ['/', '/about', '/blog/*', '/contact', '/pricing', '/products/*']);
  });

  void it('splits what is left evenly, so a small template is read whole', () => {
    const top = orderForCoverage(site(), { home: 'https://x.test' }).slice(0, 200);
    const counts = templateCounts(top);
    assert.equal(counts.get('/blog/*'), 96);
    assert.equal(counts.get('/products/*'), 100);
  });

  void it('alternates between languages and sections inside a template', () => {
    const blog = orderForCoverage(site()).filter((u) => templateKey(u) === '/blog/*');
    const firstFour = blog.slice(0, 4).map((u) => new URL(u).pathname.split('/').slice(1, -1).join('/'));
    assert.deepEqual([...firstFour].sort(), ['blog/2020', 'blog/2021', 'blog/2022', 'de/blog/2020']);
  });

  void it('does not depend on input order, and a larger cap only adds pages', () => {
    const a = orderForCoverage(site());
    const b = orderForCoverage(site().reverse());
    assert.deepEqual(a, b);
    assert.deepEqual(a.slice(0, 50), orderForCoverage(site()).slice(0, 100).slice(0, 50));
  });

  void it('puts templates already loaded behind new ones', () => {
    const seen = new Map([['/products/*', 500]]);
    const ordered = orderForCoverage(site(), { seen });
    assert.ok(!ordered.slice(0, 100).some((u) => templateKey(u) === '/products/*'));
  });

  void it('parses --max-pages', () => {
    assert.equal(parseArgs(['--origin=https://x.test', '--max-pages=800']).maxPages, 800);
    assert.equal(parseArgs(['--origin=https://x.test', '--max-pages=0']).maxPages, 0);
    assert.equal(parseArgs(['--origin=https://x.test']).maxPages, null);
    assert.equal(parseArgs(['--origin=https://x.test', '--max-pages=abc']).maxPages, null);
  });
});
