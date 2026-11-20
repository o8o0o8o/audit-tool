import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TechnologyDetector } from '../lib/analyzers/seo/technology-detector';
import { CrawlBudgetAnalyzer } from '../lib/analyzers/seo/crawl-budget-analyzer';
import { UrlArchitectureAnalyzer } from '../lib/analyzers/seo/url-architecture-analyzer';
import { cdnHtmlCacheIssues } from '../lib/analyzers/performance/asset-delivery-analyzer';
import { pageLinks, withPages } from '../lib/utils/page-links';
import type { PageInfo } from '../lib/types';

const names = (html: string, scripts: string[] = []) =>
  Object.values(TechnologyDetector.detectFromHtml(html, {}, scripts).byCategory).flat();

void describe('technology detector: page text is not evidence', () => {
  const article = `<html><body><article><h1>BigCommerce vs Shopify</h1>
    <p>We moved a store off BigCommerce and PrestaShop, removed Hotjar and Mailchimp,
    and replaced WooCommerce. Font Awesome icons, Yoast SEO and All in One SEO were dropped.
    The G-SHOCK range and <a href="https://cloudinary.com/">cloudinary.com</a> are mentioned too.</p>
    </article></body></html>`;

  void it('product names in article text detect nothing', () => {
    const found = names(article);
    for (const n of [
      'BigCommerce',
      'PrestaShop',
      'Hotjar',
      'Mailchimp',
      'WooCommerce',
      'Font Awesome',
      'Yoast SEO',
      'All in One SEO',
      'Google Analytics 4',
      'Cloudinary',
    ]) {
      assert.ok(!found.includes(n), `${n} detected from page text`);
    }
  });

  void it('the products are still detected from their own markup and files', () => {
    const found = names(
      `<html><head><link rel="stylesheet" href="https://cdn11.bigcommerce.com/s-abc/theme.css">
      <script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC1234"></script>
      <script>gtag('config', 'G-ABC1234');</script>
      <script src="https://static.hotjar.com/c/hotjar-1.js"></script></head>
      <body class="woocommerce-page"><img src="https://res.cloudinary.com/demo/image/upload/x.jpg">
      <i class="fa fa-star"></i></body></html>`,
    );
    for (const n of ['BigCommerce', 'Google Analytics 4', 'Hotjar', 'WooCommerce', 'Cloudinary', 'Font Awesome']) {
      assert.ok(found.includes(n), `${n} not detected`);
    }
  });

  void it('records the matched text as evidence', () => {
    const result = TechnologyDetector.detectFromHtml(
      '<link href="https://cdn11.bigcommerce.com/s-abc/theme.css">',
      {},
      [],
    );
    const bc = result.technologies.find((t) => t.name === 'BigCommerce');
    assert.equal(bc?.detectedBy[0]?.matched, 'cdn11.bigcommerce.com');
  });
});

void describe('site-level findings name their pages', () => {
  void it('pageLinks caps the list and links only http(s) URLs', () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://example.com/p${i}`);
    const html = pageLinks(urls);
    assert.equal((html.match(/<a href=/g) ?? []).length, 10);
    assert.ok(html.endsWith(' and 2 more'));
    assert.equal(pageLinks(['https://example.com/a', 'https://example.com/a']).match(/<a /g)?.length, 1);
    assert.ok(!pageLinks(['javascript:alert(1)']).includes('<a'));
    assert.equal(withPages('Pages', []), '');
  });

  const page = (statusCode: number, extra: Partial<PageInfo> = {}) => ({ statusCode, ...extra }) as PageInfo;

  void it('error pages are listed', () => {
    const pages = {
      'https://example.com/': page(200),
      'https://example.com/gone/': page(404),
      'https://example.com/broken/': page(500),
    };
    const issue = CrawlBudgetAnalyzer.analyze(pages).issues.find(
      (i) => i.message === 'Error pages wasting crawl budget',
    );
    assert.match(issue?.detail ?? '', /Error pages: <a href="https:\/\/example\.com\/gone\/">/);
    assert.match(issue?.detail ?? '', /example\.com\/broken\//);
  });

  void it('the minority trailing-slash URLs are listed', () => {
    const pages: Record<string, PageInfo> = {};
    for (const p of ['a/', 'b/', 'c/', 'd']) pages[`https://example.com/${p}`] = page(200);
    const issue = UrlArchitectureAnalyzer.analyzeSiteWide(pages, 'https://example.com').issues.find(
      (i) => i.message === 'Inconsistent trailing slash usage across site',
    );
    assert.match(issue?.detail ?? '', /Without a trailing slash: <a href="https:\/\/example\.com\/d">/);
  });

  void it('CDN cache misses are listed', () => {
    const [issue] = cdnHtmlCacheIssues(['miss', 'miss', 'miss', 'miss', 'miss'], ['https://example.com/x']);
    assert.match(issue.detail ?? '', /Pages: <a href="https:\/\/example\.com\/x">/);
  });
});
