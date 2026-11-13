// Regressions for the false positives found by the focusreactive.com report review
// (docs/audit-review-focusreactive-2026-11-12.md).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from 'node-html-parser';
import { consentMarkupIdentifiers } from '../lib/analyzers/security/cookie-consent-analyzer';
import { classifyLinkStatus, needsGetRetry, stripFragment } from '../lib/utils/link-status';
import {
  classifyBackgroundUpscale,
  imageFormat,
  isOversizedForDisplay,
} from '../lib/analyzers/performance/image-optimization-analyzer';
import { analyticsProvider } from '../lib/analyzers/performance/third-party-analyzer';
import { isRevealOnly } from '../lib/analyzers/seo/pagination-analyzer';
import { isNonPageAsset } from '../lib/crawler/page-data-builder';
import { TechnologyDetector } from '../lib/analyzers/seo/technology-detector';
import { collectResourceHints } from '../lib/analyzers/performance/resource-hints-analyzer';
import { RedirectChainAnalyzer } from '../lib/analyzers/performance/redirect-chain-analyzer';
import { EEATAnalyzer } from '../lib/analyzers/seo/eeat-analyzer';
import { OpenRedirectAnalyzer } from '../lib/analyzers/security/open-redirect-analyzer';
import { ErrorAggregator, isSiteLevelFinding } from '../lib/utils/error-aggregator';
import { AdvancedSchemaValidator } from '../lib/analyzers/seo/advanced-schema-validator';
import type { PageInfo, ParsedPage } from '../lib/types';

const html = (s: string) => parse(s) as unknown as ParsedPage;

void describe('consent platform fingerprinting', () => {
  void it('ignores words in comments and text ("trusted", an article about cookieconsent)', () => {
    const page = html(
      '<html><body><script>// only v4 ids are trusted</script><p>How cookieconsent works</p></body></html>',
    );
    const markup = consentMarkupIdentifiers(page);
    assert.ok(!markup.includes('truste'));
    assert.ok(!markup.includes('cookieconsent'));
  });

  void it('still sees CMP script URLs and ids', () => {
    const page = html('<script src="https://consent.trustarc.com/notice"></script><div id="onetrust-banner-sdk"></div>');
    const markup = consentMarkupIdentifiers(page);
    assert.ok(markup.includes('consent.trustarc'));
    assert.ok(markup.includes('onetrust'));
  });
});

void describe('external link status', () => {
  void it('treats bot refusals as blocked, not broken', () => {
    for (const s of [401, 403, 405, 419, 429, 999]) assert.strictEqual(classifyLinkStatus(s), 'blocked', String(s));
    for (const s of [404, 410, 500, 503]) assert.strictEqual(classifyLinkStatus(s), 'dead', String(s));
    assert.strictEqual(classifyLinkStatus(200), 'ok');
    assert.strictEqual(classifyLinkStatus(0), 'unknown');
  });

  void it('retries HEAD errors with GET and drops fragments', () => {
    assert.ok(needsGetRetry(405));
    assert.ok(!needsGetRetry(200));
    assert.strictEqual(stripFragment('https://x.test/a#b'), 'https://x.test/a');
  });
});

void describe('image checks', () => {
  const base = { naturalWidth: 1200, naturalHeight: 1227, displayWidth: 18, displayHeight: 18 };

  void it('never flags SVG or inline images as larger than displayed', () => {
    assert.ok(!isOversizedForDisplay({ ...base, src: 'https://x.test/x-logo.svg' }, 1));
    assert.ok(!isOversizedForDisplay({ ...base, src: 'data:image/png;base64,AA' }, 1));
    assert.ok(isOversizedForDisplay({ ...base, src: 'https://x.test/photo.jpg' }, 1));
  });

  void it('allows for device pixel ratio', () => {
    const img = { src: 'https://x.test/a.jpg', naturalWidth: 640, naturalHeight: 640, displayWidth: 200, displayHeight: 200 };
    assert.ok(isOversizedForDisplay(img, 1)); // 3.2x at 1x DPR
    assert.ok(!isOversizedForDisplay(img, 2)); // within 2x of 400px at 2x DPR
  });

  void it('reads the format from Content-Type before the extension', () => {
    assert.strictEqual(imageFormat('https://x.test/_vercel/image?url=a', { headers: { 'content-type': 'image/avif' } }), 'modern');
    assert.strictEqual(imageFormat('https://x.test/a.png'), 'legacy');
    assert.strictEqual(imageFormat('https://x.test/a.svg'), 'vector');
  });

  void it('does not flag a deliberately blurred backdrop as upscaled', () => {
    const bg = {
      url: 'https://x.test/thumb.jpg',
      naturalWidth: 64,
      naturalHeight: 64,
      elementWidth: 434,
      elementHeight: 300,
      backgroundSize: 'cover',
      backgroundRepeat: 'no-repeat',
    };
    assert.ok(classifyBackgroundUpscale(bg, 1));
    assert.ok(!classifyBackgroundUpscale({ ...bg, filter: 'blur(24px)' }, 1));
  });
});

void describe('third-party and tech detection', () => {
  void it('counts analytics vendors, not hostnames', () => {
    const hosts = ['www.clarity.ms', 'scripts.clarity.ms', 'q.clarity.ms', 'www.googletagmanager.com', 'region1.analytics.google.com'];
    assert.deepStrictEqual([...new Set(hosts.map(analyticsProvider))].sort(), ['Google Analytics / GTM', 'Microsoft Clarity']);
  });

  void it('ignores framework names quoted in code samples', () => {
    const article = "<html><body><pre><code>matcher: '/((?!api|_next/static).*)'</code></pre></body></html>";
    assert.strictEqual(TechnologyDetector.quickDetectFramework(article), null);
  });
});

void describe('crawl scope', () => {
  void it('never queues files as pages', () => {
    assert.ok(isNonPageAsset('https://x.test/media/posts/image.png'));
    assert.ok(isNonPageAsset('https://x.test/media/roadmap.pdf'));
    assert.ok(isNonPageAsset('https://x.test/media/clip.mp4'));
    assert.ok(!isNonPageAsset('https://x.test/blog/post/'));
  });

  void it('"Show more" that reveals server-rendered items is not a crawl problem', () => {
    const served = '<a href="/case-a/">A</a><a href="/case-b/">B</a>';
    assert.ok(isRevealOnly(['/case-a/', '/case-b/'], served));
    assert.ok(!isRevealOnly(['/case-c/'], served));
    assert.ok(!isRevealOnly([], served));
  });
});

void describe('resource hints', () => {
  void it('reads preload / preconnect links from the page', () => {
    const page = html(
      '<head><link rel="preload" href="/f.woff2" as="font" crossorigin><link rel="preconnect" href="https://cdn.test"></head>',
    );
    const hints = collectResourceHints(page, 'https://x.test/');
    assert.strictEqual(hints.preload?.[0]?.href, 'https://x.test/f.woff2');
    assert.strictEqual(hints.preload?.[0]?.as, 'font');
    assert.strictEqual(hints.preconnect?.length, 1);
  });
});

void describe('redirect chain', () => {
  void it('counts hops, not chain entries (the final 200 is not a redirect)', () => {
    const res = RedirectChainAnalyzer.analyze(
      {
        redirectChain: [
          { url: 'https://x.test/a', status: 308 },
          { url: 'https://x.test/b/', status: 200 },
        ],
      } as unknown as PageInfo,
      'https://x.test/a',
    );
    assert.strictEqual(res.info.redirectCount, 1);
    assert.ok(![...res.issues, ...res.warnings].some((i) => i.message === 'Multiple redirects detected'));
  });
});

void describe('YMYL detection', () => {
  void it('matches whole path words, not client names', () => {
    const empty = html('<html><body><p>Case study</p></body></html>');
    assert.ok(!EEATAnalyzer.detectYMYL('https://x.test/quanthealth-case-study/', empty));
    assert.ok(!EEATAnalyzer.detectYMYL('https://x.test/marketfinance-case-study/', empty));
    assert.ok(EEATAnalyzer.detectYMYL('https://x.test/health/sleep-tips/', empty));
  });
});

void describe('open redirect', () => {
  void it('ignores third-party share intents', () => {
    const page = html(
      [1, 2, 3, 4, 5]
        .map((i) => `<a href="https://www.linkedin.com/sharing/share-offsite/?url=https://x.test/p${i}">s</a>`)
        .join(''),
    );
    const res = OpenRedirectAnalyzer.analyze({} as PageInfo, page, 'https://x.test/p');
    assert.strictEqual(res.info.suspiciousLinks.length, 0);
  });
});

void describe('site-level findings', () => {
  void it('collapse into one site-wide entry and keep the page count', () => {
    const agg = new ErrorAggregator();
    for (let i = 0; i < 20; i++) agg.addError('Missing Permissions-Policy header', `<a href="https://x.test/p${i}">p${i}</a>`, 'medium');
    agg.addError('Duplicate titles detected', 'a', 'medium');
    const collapsed = agg.collapseSiteLevelFindings(20);
    assert.deepStrictEqual(collapsed, ['Missing Permissions-Policy header']);
    const d = agg.getRawData().details['Missing Permissions-Policy header'];
    assert.strictEqual(d.count, 20);
    assert.strictEqual(d.examples.length, 2);
    assert.match(d.examples[0], /^Site-wide: 20 of 20/);
    assert.ok(isSiteLevelFinding('LocalBusiness missing recommended field: geo'));
  });

  void it('reports a schema field once per page even with several blocks of that type', () => {
    const office = (city: string) => ({ '@type': 'LocalBusiness', name: city, address: { streetAddress: 's', addressLocality: city, addressCountry: 'GB' } });
    const res = AdvancedSchemaValidator.validate(
      {
        structuredData: {
          jsonLdSchemas: ['London', 'Warsaw', 'New York'].map((c) => ({ type: 'LocalBusiness', raw: office(c) })),
        },
      } as unknown as PageInfo,
      'https://x.test/',
    );
    const geo = [...res.issues, ...res.warnings].filter((i) => i.message === 'LocalBusiness missing recommended field: geo');
    assert.strictEqual(geo.length, 1);
  });
});
