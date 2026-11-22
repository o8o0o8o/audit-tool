import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { slimSections } from '../lib/model/build/build-audit-model';

void describe('stored page record', () => {
  const page = {
    url: 'https://x.test/a',
    title: 'A',
    siteHints: { scripts: ['a.js'] },
    contentHash: 'abc',
    ctas: [{ text: 'Buy' }],
    ctaData: { ctas: [{ text: 'Buy' }], summary: { total: 1 } },
    resourceHints: { preload: [], prefetch: [{ href: 'a.js' }] },
    resourceHintsData: { preload: [], prefetch: [{ href: 'a.js' }], missingHints: [] },
    newAnalyzerData: { anything: true },
  };

  void it('drops crawl-time working data and exact duplicates, and keeps every other key', () => {
    const slim = slimSections(page);
    assert.deepEqual(Object.keys(slim).sort(), ['ctaData', 'newAnalyzerData', 'resourceHintsData', 'title', 'url']);
    assert.deepEqual(slim.ctaData, page.ctaData);
    assert.deepEqual(slim.resourceHintsData, page.resourceHintsData);
  });

  void it('keeps a key that differs from its copy, or has no copy', () => {
    assert.ok('ctas' in slimSections({ ...page, ctas: [{ text: 'Other' }] }));
    assert.ok('ctas' in slimSections({ ctas: [{ text: 'Buy' }] }));
    assert.ok('resourceHints' in slimSections({ ...page, resourceHints: { preload: [{ href: 'x' }] } }));
    assert.ok('resourceHints' in slimSections({ resourceHints: { preload: [] } }));
  });

  void it('does not change the record it is given', () => {
    const copy = structuredClone(page);
    slimSections(page);
    assert.deepEqual(page, copy);
  });
});
