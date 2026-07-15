import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';

import { parse as parseHtml } from 'node-html-parser';
import { parseArgs } from '../lib/args-parser';
import { isNoPlaywright, assertBrowserAllowed } from '../lib/crawler/browser-guard';
import { fetchPageViaHttp } from '../lib/crawler/http-fetch';
import { StructuredDataAnalyzer } from '../lib/analyzers/seo/structured-data-analyzer';
import { AriaLiveAnalyzer } from '../lib/analyzers/accessibility/aria-live-analyzer';
import { LinkQualityAnalyzer } from '../lib/analyzers/content/link-quality-analyzer';
import { runAnalyzers } from '../lib/crawler/analyzer-runner';
import type { ParsedPage, PageInfo } from '../lib/types';
import type { CrawlerInternalOptions } from '../lib/crawler/crawler-types';

// ============================================================
// --no-playwright: flag parsing (AC1 / R1)
// ============================================================
void describe('--no-playwright flag parsing', () => {
  void it('defaults to false when the flag is absent', () => {
    const args = parseArgs(['--origin=https://example.com']);
    assert.strictEqual(args.noPlaywright, false);
  });

  void it('is true when --no-playwright is passed', () => {
    const args = parseArgs(['--origin=https://example.com', '--no-playwright']);
    assert.strictEqual(args.noPlaywright, true);
  });
});

// ============================================================
// browser-launch guard invariant (AC3 / R2)
// ============================================================
void describe('browser-guard invariant', () => {
  const prev = process.env.SEO_AUDIT_NO_PLAYWRIGHT;
  afterEach(() => {
    if (prev === undefined) delete process.env.SEO_AUDIT_NO_PLAYWRIGHT;
    else process.env.SEO_AUDIT_NO_PLAYWRIGHT = prev;
  });

  void it('isNoPlaywright reflects the process signal', () => {
    delete process.env.SEO_AUDIT_NO_PLAYWRIGHT;
    assert.strictEqual(isNoPlaywright(), false);
    process.env.SEO_AUDIT_NO_PLAYWRIGHT = '1';
    assert.strictEqual(isNoPlaywright(), true);
  });

  void it('assertBrowserAllowed throws when no-playwright is active', () => {
    process.env.SEO_AUDIT_NO_PLAYWRIGHT = '1';
    assert.throws(() => assertBrowserAllowed('test-site'), /no-playwright/i);
  });

  void it('assertBrowserAllowed is a no-op by default (flag off)', () => {
    delete process.env.SEO_AUDIT_NO_PLAYWRIGHT;
    assert.doesNotThrow(() => assertBrowserAllowed('test-site'));
  });
});

// ============================================================
// http-fetch: SSRF gating (network-free, deterministic) (R3 edge)
// ============================================================
void describe('fetchPageViaHttp SSRF gating', () => {
  void it('blocks a private/internal host without hitting the network', async () => {
    const res = await fetchPageViaHttp('http://127.0.0.1:9/secret');
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.html, '');
    assert.match(res.error ?? '', /SSRF-blocked/);
  });

  void it('blocks an unsupported protocol', async () => {
    const res = await fetchPageViaHttp('file:///etc/passwd');
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.html, '');
    assert.ok(res.error, 'expected an error for a non-http(s) URL');
  });
});

// ============================================================
// bucket-b analyzers run browser-free from parsedPage (AC11 / R10)
// ============================================================
void describe('bucket-b analyzers (no-playwright, parsedPage path)', () => {
  void it('structured-data extracts + validates JSON-LD from parsed HTML (chromePage null)', async () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Widget"}</script>
      </head><body><div itemscope itemtype="https://schema.org/Organization"></div></body></html>`;
    const parsed = parseHtml(html) as unknown as ParsedPage;
    const res = await StructuredDataAnalyzer.analyzeStructuredData(null, parsed);
    assert.strictEqual(res.hasStructuredData, true);
    assert.strictEqual(res.jsonLdSchemas.length, 1);
    assert.strictEqual(res.jsonLdSchemas[0].type, 'Product');
    // Product requires name+description → a missing-description validation error.
    assert.ok(res.validationErrors.some((e) => /description/i.test(e)));
    assert.strictEqual(res.microdataItems.length, 1);
  });

  void it('aria-live counts live regions from parsed HTML (chromePage null)', async () => {
    const html = `<html><body>
      <div aria-live="assertive">Alert!</div>
      <div aria-live="polite"></div>
      <div role="status">Loading</div>
      </body></html>`;
    const parsed = parseHtml(html) as unknown as ParsedPage;
    const res = await AriaLiveAnalyzer.analyze(null, parsed, 'https://x.test/');
    assert.strictEqual(res.info.totalLiveRegions, 3);
    assert.strictEqual(res.info.assertiveRegions, 1);
    assert.ok(res.info.emptyLiveRegions >= 1); // the empty polite region
  });

  void it('link-quality reads links from parsed HTML with absolute hrefs (chromePage null)', async () => {
    const html = `<html><body>
      <a href="/about">About</a>
      <a href="https://external.test/x" rel="nofollow">Ext</a>
      </body></html>`;
    const parsed = parseHtml(html) as unknown as ParsedPage;
    const res = await LinkQualityAnalyzer.analyzeLinkQuality(
      null,
      parsed,
      'https://mysite.test/page',
      'https://mysite.test',
      {} as Record<string, PageInfo>,
    );
    assert.strictEqual(res.totalLinks, 2);
    assert.ok(res.internalLinks >= 1);
    assert.ok(res.externalLinks >= 1);
  });
});

// ============================================================
// End-to-end: fetched HTML → runAnalyzers → per-page findings, browser-free (AC5 / R4)
// ============================================================
void describe('runAnalyzers browser-free (no-playwright, chromePage null)', () => {
  void it('runs bucket-a analyzers on parsed HTML and reports ≥1 SEO finding without a browser', async () => {
    // A page missing a <title> and <h1> — bucket-a analyzers (heading, meta,
    // indexability, etc.) should surface findings purely from parsedPage.
    const html = `<html lang="en"><head><meta charset="utf-8"></head><body><p>hi</p></body></html>`;
    const parsed = parseHtml(html) as unknown as ParsedPage;
    const pageData = { url: 'https://mysite.test/', status: 200, responseHeaders: {} } as unknown as PageInfo;
    const issues: string[] = [];
    const reportIssue = (message: string) => issues.push(message);
    const options = {
      noPlaywright: true,
      perf: false,
      origin: 'https://mysite.test',
      verbose: false,
      analysis: {},
    } as unknown as CrawlerInternalOptions;

    await runAnalyzers(null, parsed, 'https://mysite.test/', pageData, html, {}, null, options, reportIssue);

    // The crawl completed analysis without a browser and produced findings.
    assert.ok(issues.length >= 1, `expected ≥1 finding from bucket-a analyzers, got ${issues.length}`);
  });
});
