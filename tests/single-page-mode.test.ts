import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseArgs } from '../lib/args-parser';
import { AuditOrchestrator } from '../lib/orchestrators/audit-orchestrator';
import {
  MULTI_PAGE_VALIDATORS,
  keepSinglePageSitemapEntries,
  robotsBlockedPageFinding,
} from '../lib/orchestrators/single-page';
import { buildCheckpointMetadata } from '../lib/orchestrators/progress-manager';
import { withQuickScanLabel } from '../generateHTML';
import type { PageInfo } from '../lib/types';

void describe('--page argument', () => {
  void it('keeps the page URL and audits its origin', () => {
    const args = parseArgs(['--page=example.com/pricing?plan=pro#faq']);
    assert.equal(args.page, 'https://example.com/pricing?plan=pro');
    assert.equal(args.origin, 'https://example.com');
    assert.deepStrictEqual(args.errors, []);
  });

  void it('drops --limit, --exclude and --content-research with a warning', () => {
    const args = parseArgs(['--page=https://example.com/a', '--limit=10', '--exclude=/blog', '--content-research']);
    assert.equal(args.limit, null);
    assert.deepStrictEqual(args.exclude, []);
    assert.equal(args.contentResearch, false);
    assert.equal(args.warnings.length, 3);
  });

  void it('rejects a bad URL, another origin, and modes that need many pages', () => {
    assert.ok(parseArgs(['--page=ftp://example.com/a']).errors.some((e) => e.startsWith('--page')));
    assert.ok(parseArgs(['--origin=https://other.com', '--page=https://example.com/a']).errors.length > 0);
    assert.ok(parseArgs(['--page=https://example.com/a', '--lead']).errors.some((e) => e.includes('--lead')));
    assert.ok(parseArgs(['--page=https://example.com/a', '--compare=https://b.com']).errors.length > 0);
  });

  void it('changes nothing without the flag', () => {
    const args = parseArgs(['--origin=https://example.com/some/page', '--limit=10']);
    assert.equal(args.page, null);
    assert.equal(args.origin, 'https://example.com');
    assert.equal(args.limit, 10);
  });
});

void describe('single-page rules', () => {
  void it('reports a page robots.txt keeps Googlebot away from', () => {
    const robots = { userAgents: { '*': { allow: [], disallow: ['/private'] } } };
    assert.equal(robotsBlockedPageFinding('https://example.com/public', robots), null);
    const finding = robotsBlockedPageFinding('https://example.com/private/x', robots);
    assert.equal(finding?.message, 'Page is blocked by robots.txt');
    assert.equal(finding?.severity, 'high');
    // A Googlebot group overrides the wildcard.
    const google = { userAgents: { '*': { allow: [], disallow: ['/'] }, Googlebot: { allow: [], disallow: [] } } };
    assert.equal(robotsBlockedPageFinding('https://example.com/x', google), null);
    assert.equal(robotsBlockedPageFinding('https://example.com/x', { userAgents: {} }), null);
  });

  void it('keeps only the page sitemap entry, in any slash form', () => {
    const urls = { 'https://example.com/a/': { loc: 'a' }, 'https://example.com/b': { loc: 'b' } };
    assert.deepStrictEqual(keepSinglePageSitemapEntries(urls, ['https://example.com/a']), {
      kept: { 'https://example.com/a/': { loc: 'a' } },
      inSitemap: true,
    });
    assert.deepStrictEqual(keepSinglePageSitemapEntries(urls, ['https://example.com/c']), { kept: {}, inSitemap: false });
    assert.deepStrictEqual(keepSinglePageSitemapEntries({}, ['https://example.com/c']), { kept: {}, inSitemap: null });
  });

  void it('every skipped validator name matches a validator', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'orchestrators', 'audit-orchestrator.ts'), 'utf8');
    for (const name of MULTI_PAGE_VALIDATORS) {
      assert.ok(source.includes(`name: '${name}'`), `no validator named "${name}"`);
    }
  });

  void it('labels the report and records the page in the checkpoint', () => {
    assert.equal(withQuickScanLabel('Full audit', { singlePage: { url: 'https://example.com/a' } }), 'Single page: https://example.com/a');
    assert.equal(
      withQuickScanLabel('Sales', { singlePage: { url: 'https://example.com/a', finalUrl: 'https://example.com/b' } }),
      'Sales · Single page: https://example.com/b',
    );
    const base = { robots: {}, sitemaps: {}, analysis: { overall: [], details: {}, bySeverity: {}, summary: {} }, pageData: { pages: {}, processedPages: [], totalWithoutError: 0, totalWithError: 0, byError: {}, attempts: {} } };
    assert.deepStrictEqual(buildCheckpointMetadata({ ...base, singlePage: { url: 'https://example.com/a' } }).singlePage, {
      url: 'https://example.com/a',
    });
    assert.equal('singlePage' in buildCheckpointMetadata(base), false);
  });
});

void describe('single-page crawl', () => {
  function run(sitemapUrls: Record<string, object>, onCrawl: (url: string, pages: Record<string, PageInfo>) => void) {
    const crawled: string[][] = [];
    const findings: string[] = [];
    const results = {
      sitemaps: { urls: sitemapUrls as Record<string, never>, total: Object.keys(sitemapUrls).length },
      pageData: {
        pages: {} as Record<string, PageInfo>,
        processedPages: new Set<string>(),
        totalWithoutError: 0,
        totalWithError: 0,
        byError: {},
        attempts: {},
      },
    } as Parameters<typeof AuditOrchestrator.analyzePages>[0]['results'];
    const crawlerEngine = {
      crawlPages: async (opts: Record<string, unknown>) => {
        const list = opts.pagesToCrawl as string[];
        crawled.push([...list]);
        for (let i = 0; i < list.length; i++) onCrawl(list[i], results.pageData.pages);
        return { alternatesErrors: [], isMultiLang: false, failedPages: [] };
      },
      finalizeIncomingLinks: () => {},
    };
    return {
      crawled,
      findings,
      results,
      go: () =>
        AuditOrchestrator.analyzePages({
          results,
          crawlerEngine,
          incomingLinksTracking: new Map(),
          saveError: (message: string) => findings.push(message),
          resultsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'single-page-')),
          origin: 'https://example.com',
          singlePage: 'https://example.com/a',
        }),
    };
  }

  const ok = (url: string): PageInfo => ({ url, status: 200 }) as PageInfo;

  void it('loads only the page, in the form the sitemap lists it', async () => {
    const t = run({ 'https://example.com/a/': {}, 'https://example.com/b': {} }, (url, pages) => {
      pages[url] = ok(url);
    });
    await t.go();
    assert.deepStrictEqual(t.crawled, [['https://example.com/a/']]);
    assert.deepStrictEqual(Object.keys(t.results.sitemaps.urls), ['https://example.com/a/']);
    assert.equal(t.results.singlePage?.inSitemap, true);
    assert.deepStrictEqual(t.findings, []);
  });

  void it('follows a same-site redirect and reports a page missing from the sitemap', async () => {
    const t = run({ 'https://example.com/b': {} }, (url, pages) => {
      if (url === 'https://example.com/a') {
        pages[url] = { url, status: 301, redirectOnly: true, finalUrl: 'https://example.com/a-new' } as PageInfo;
        pages['https://example.com/a-new'] = ok('https://example.com/a-new');
      }
    });
    await t.go();
    assert.deepStrictEqual(t.results.singlePage, {
      url: 'https://example.com/a',
      finalUrl: 'https://example.com/a-new',
      inSitemap: false,
    });
    assert.deepStrictEqual(t.findings, ['Some URLs are not listed in sitemap']);
    assert.equal(t.results.sitemaps.total, 0);
  });
});
