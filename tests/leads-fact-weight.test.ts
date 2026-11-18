import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTeaserReady, pageShare, sortByWeight, weighFact, type FactWeight } from '../lib/leads/fact-weight';
import { rankHighlights, type Highlight } from '../lib/leads/truth-gate';

const fact = (type: string, text: string, rootCause = type) => ({ type, rootCause, fact: text, evidence: {} });
const weigh = (type: string, text: string) => weighFact(fact(type, text));

void describe('fact weight', () => {
  void it('software past its end of life, slow real-user speed, an empty key page and lost analytics are heavy', () => {
    assert.equal(
      weigh('end-of-life', 'The site is built with Nuxt 2, which stopped receiving fixes on 2024-06-30'),
      'heavy',
    );
    assert.equal(
      weigh(
        'poor-vitals',
        'For real visitors on phones the site takes 1128 ms to respond to a tap at the 75th percentile',
      ),
      'heavy',
    );
    assert.equal(
      weigh('content-not-served', 'The HTML the server sends for /available-vehicles holds no text at all'),
      'heavy',
    );
    assert.equal(weigh('analytics-gap', 'Google sends back an empty container'), 'heavy');
  });

  void it('a framework is heavy only when it is at least two major versions behind its fix', () => {
    const next = (have: string, fixed: string) =>
      weigh(
        'vulnerable-library',
        `The site runs on Next.js ${have} (the version is in its own script main-1.js): a version with 17 published security advisories (GHSA-2xp9-vwfh-vxw4 and 14 more); all fixed from version ${fixed}`,
      );
    assert.equal(next('10.2.3', '15.5.28'), 'heavy');
    assert.equal(next('13.1.6', '15.5.28'), 'heavy');
    assert.equal(next('14.2.35', '15.5.28'), 'light');
    assert.equal(next('16.3.4', '16.4.1'), 'light');
    assert.equal(
      weigh(
        'vulnerable-library',
        'The site runs on AngularJS 1.8.3 (the version is in its own script app.js): a version with 9 published security advisories (CVE-2024-21490); no fixed release in the 1.x line',
      ),
      'heavy',
    );
  });

  void it('a bundled library with an advisory is light, however many advisories', () => {
    assert.equal(
      weigh(
        'vulnerable-library',
        'The site loads axios 0.21.4 in its own script 4b21589.modern.js: a version with 24 published security advisories (CVE-2025-62718 and 20 more); all fixed from version 1.6.8',
      ),
      'light',
    );
    assert.equal(
      weigh(
        'vulnerable-library',
        'The site loads jQuery 3.4.1, a version with a published security advisory (CVE-2020-11022); it is fixed from version 3.5.0',
      ),
      'light',
    );
  });

  void it('a dead link is heavy when it is in the main navigation across the site, light in the footer', () => {
    assert.equal(
      weigh(
        'dead-nav-link',
        'The "Flights" link in the navigation returns 404 on 16 of 21 pages scanned; 2 more navigation links do the same',
      ),
      'heavy',
    );
    assert.equal(weigh('dead-nav-link', 'The "عربي" link in the header returns 404 on all 25 pages scanned'), 'heavy');
    assert.equal(weigh('dead-nav-link', 'A link in the header returns 404 on 5 of 22 pages scanned'), 'heavy');
    assert.equal(weigh('dead-nav-link', 'A link in the header returns 404 on 2 of 19 pages scanned'), 'medium');
    assert.equal(
      weigh('dead-nav-link', 'The "For more information" link in the footer returns 404 on 15 of 18 pages scanned'),
      'light',
    );
  });

  void it('a blocked tag is heavy when the vendor is known and it is blocked across the site', () => {
    assert.equal(
      weigh(
        'blocked-by-policy',
        "The site's own Content Security Policy blocks Google Analytics on 23 of 25 pages scanned: its connect-src list does not include region1.google-analytics.com, so the browser refuses the request",
      ),
      'heavy',
    );
    assert.equal(
      weigh(
        'blocked-by-policy',
        "The site's own Content Security Policy blocks Google Tag Manager on 2 of 24 pages scanned: its img-src list does not include www.googletagmanager.com",
      ),
      'medium',
    );
    assert.equal(
      weigh(
        'blocked-by-policy',
        "The site's own Content Security Policy blocks requests to embeds.acswapp.com on 15 of 23 pages scanned: its img-src list does not include embeds.acswapp.com",
      ),
      'medium',
    );
  });

  void it('contained defects are medium and hygiene is light', () => {
    for (const type of [
      'noindex',
      'product-no-price',
      'missing-hreflang',
      'missing-page-status',
      'broken-image',
      'template-text',
      'tracking-before-consent',
    ])
      assert.equal(weigh(type, 'x'), 'medium', type);
    for (const type of ['unnamed-controls', 'email-auth', 'sitemap-dead-urls'])
      assert.equal(weigh(type, 'x'), 'light', type);
  });

  void it('reads the share of pages from the gate wording', () => {
    assert.deepEqual(pageShare('returns 404 on 16 of 21 pages scanned'), { pages: 16, scanned: 21 });
    assert.deepEqual(pageShare('on all 24 pages scanned'), { pages: 24, scanned: 24 });
    assert.deepEqual(pageShare('on 1 of 1 page scanned'), { pages: 1, scanned: 1 });
    assert.equal(pageShare('4 of 20 sitemap addresses we sampled return 404'), null);
  });
});

void describe('teaser readiness and order', () => {
  const f = (rootCause: string, weight: FactWeight) => ({ rootCause, weight });

  void it('needs enough causes and one heavy fact among them', () => {
    assert.equal(isTeaserReady([f('a', 'light'), f('b', 'medium'), f('c', 'light')], 3), false);
    assert.equal(isTeaserReady([f('a', 'light'), f('b', 'heavy'), f('c', 'light')], 3), true);
    assert.equal(isTeaserReady([f('a', 'heavy'), f('b', 'heavy')], 3), false);
  });

  void it('puts the heaviest first and keeps the given order between equals', () => {
    assert.deepEqual(
      sortByWeight([
        f('a', 'light'),
        f('b', 'medium'),
        f('c', 'heavy'),
        f('d', 'medium'),
        { rootCause: 'e' } as { rootCause: string; weight?: FactWeight },
      ]).map((x) => x.rootCause),
      ['c', 'b', 'd', 'a', 'e'],
    );
  });

  void it('ranks stored highlights: weight first, then the cause order, and the platform after other heavy facts', () => {
    const h = (type: string, rootCause: string, text: string): Highlight => ({
      type: type as Highlight['type'],
      rootCause,
      angle: 'x',
      fact: text,
      url: 'https://example.com/',
      evidence: {
        methods: ['a', 'b'],
        control: { homepage: 200, randomMissing: 404 },
        checkedAt: '2026-11-18T10:00:00.000Z',
      },
      gate: 'pass',
    });
    const ranked = rankHighlights([
      h('unnamed-controls', 'unnamed-controls', 'x'),
      h('end-of-life', 'end-of-life:nuxt', 'The site is built with Nuxt 2'),
      h('noindex', 'noindex', 'x'),
      h('poor-vitals', 'real-user-performance', 'x'),
      h('email-auth', 'email-authentication', 'x'),
    ]);
    assert.deepEqual(
      ranked.map((x) => [x.rootCause, x.weight]),
      [
        ['real-user-performance', 'heavy'],
        ['end-of-life:nuxt', 'heavy'],
        ['noindex', 'medium'],
        ['email-authentication', 'light'],
        ['unnamed-controls', 'light'],
      ],
    );
  });
});
