import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentGapAnalyzer, isArchiveUrl } from '../lib/analyzers/site-wide/content-gap-analyzer';
import type { PageInfo } from '../lib/types';

void test('isArchiveUrl matches author/category/tag/page listings only', () => {
  assert.ok(isArchiveUrl('https://x.com/blog/author/IrinaKostareva/'));
  assert.ok(isArchiveUrl('https://x.com/blog/category/sanity/'));
  assert.ok(isArchiveUrl('https://x.com/blog/page/2/'));
  assert.ok(!isArchiveUrl('https://x.com/blog/headless-cms-architecture/'));
});

void test('content gaps ignore author archives and bare numbers', () => {
  const kw = (words: string[]) =>
    ({ contentQuality: { topKeywords: words.map((word) => ({ word, count: 9, density: 5 })) } }) as unknown as PageInfo;
  const index = ContentGapAnalyzer.buildKeywordIndex({
    'https://x.com/blog/author/IrinaKostareva/': kw(['kostareva', 'irina']),
    'https://x.com/blog/post/': kw(['headless', '2026']),
  });
  assert.deepEqual([...index.keys()], ['headless']);
});
